import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:openbot_mobile/features/bot_library/template_manager.dart';
import 'package:openbot_mobile/features/bot_library/template_operation.dart';
import 'package:openbot_mobile/features/bot_library/library_transport.dart';
import 'package:openbot_mobile/features/bot_library/library_data.dart';
import 'library_support.dart';
import 'template_support.dart';
import 'support.dart';

void main() {
  test(
    'source preview is read only; draft creation captures exact source and conversation',
    () async {
      final server = TemplateServer();
      final f = await fixture(server.handle);
      final c = TemplateManager(f.scope);
      await c.initialize();
      expect(c.bots.map((b) => b['id']), ['bot-a']);
      await c.previewSource('bot-a');
      expect(server.mutations, isEmpty);
      expect(c.conversationId, 'chat-a');
      await c.create();
      final body = jsonDecode(server.mutations.single.body);
      expect(body['sourceAgentId'], 'bot-a');
      expect(body['sourceConversationId'], 'chat-a');
      expect(body['expectedSourceRevision'], 'a' * 64);
      expect(body.containsKey('audience'), false);
      expect(c.operation.result?['publication'], isNull);
      expect(await c.operation.finish(), true);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'draft edit, explicit publish and revoke use both relevant revisions',
    () async {
      final server = TemplateServer();
      final f = await fixture(server.handle);
      final c = TemplateManager(f.scope);
      await c.initialize();
      await c.previewTemplate(templateId);
      final draft = libraryBlueprint();
      draft['profile']['instructions'] = 'Private reviewed change';
      await c.change('Edit', draft: draft);
      final edit = jsonDecode(server.mutations.single.body);
      expect(edit['expectedRevision'], libraryRevision);
      expect(edit['expectedDraftRevision'], templateDraft);
      expect(
        edit['blueprint']['profile']['instructions'],
        'Private reviewed change',
      );
      expect(server.mutations.single.method, 'PATCH');
      expect(
        f.secrets.values.values.join(),
        isNot(contains('Private reviewed change')),
      );
      await c.finish();
      await c.previewTemplate(templateId);
      await c.change('Publish', audience: 'team');
      final publish = jsonDecode(server.mutations.last.body);
      expect(publish['expectedRevision'], libraryRevision);
      expect(publish['expectedDraftRevision'], templateDraft);
      expect(publish['audience'], 'team');
      await c.finish();
      await c.previewTemplate(templateId);
      await c.change('Revoke');
      expect(
        jsonDecode(server.mutations.last.body).keys,
        containsAll(['requestId', 'expectedRevision']),
      );
      expect(
        jsonDecode(server.mutations.last.body).containsKey('blueprint'),
        false,
      );
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'refresh refuses a source changed after review and never publishes',
    () async {
      final server = TemplateServer();
      final f = await fixture(server.handle);
      final c = TemplateManager(f.scope);
      await c.initialize();
      await c.previewTemplate(templateId);
      await c.previewRefresh();
      server.sourceRevision = 'c' * 64;
      await c.change('Refresh');
      expect(server.mutations, isEmpty);
      expect(c.error, 'mobileLibrarySourceChanged');
      await c.previewRefresh();
      await c.change('Refresh');
      expect(
        jsonDecode(server.mutations.single.body)['expectedSourceRevision'],
        'c' * 64,
      );
      expect(server.mutations.single.url.path.endsWith('/refresh'), true);
      c.dispose();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    'lost response is looked up after remount without replay; pending projection repairs explicitly',
    () async {
      final server = TemplateServer()..projectionPending = true;
      final f = await fixture((r) async {
        final response = await server.handle(r);
        if (r.method == 'PATCH') throw http.ClientException('Lost');
        return response;
      });
      final transport = LibraryTransport(f.scope);
      final c = TemplateOperation(transport);
      await c.initialize();
      await c.start('Edit', templateId, {
        'expectedRevision': libraryRevision,
        'expectedDraftRevision': templateDraft,
        'blueprint': libraryBlueprint(),
      });
      expect(c.pending, isNotNull);
      c.dispose();
      final recovered = TemplateOperation(transport);
      await recovered.initialize();
      expect(recovered.result?['id'], templateId);
      expect(recovered.canRetry, false);
      expect(await recovered.finish(), false);
      expect(server.mutations.length, 1);
      await recovered.sync();
      expect(server.mutations.last.url.path.endsWith('/sync'), true);
      expect(await recovered.finish(), true);
      recovered.dispose();
      transport.close();
      f.scope.dispose();
      f.session.dispose();
    },
  );
  test(
    '404 lookup retains original marker, proven rejection clears it, storage failure writes nothing',
    () async {
      for (final mode in ['lost', 'safe', 'storage']) {
        final server = TemplateServer();
        final f = await fixture((r) async {
          if (r.method == 'PATCH') {
            server.requests.add(r);
            if (mode == 'safe') {
              return jsonResponse({
                'error': 'Conflict',
                'code': 'BOT_TEMPLATE_NOT_APPLIED',
              }, status: 409);
            }
            throw http.ClientException('Not delivered');
          }
          return server.handle(r);
        });
        final t = LibraryTransport(f.scope),
            c = TemplateOperation(LibraryTransport(f.scope));
        await c.initialize();
        f.secrets.rejectWrites = mode == 'storage';
        await c.start('Edit', templateId, {
          'expectedRevision': libraryRevision,
          'expectedDraftRevision': templateDraft,
          'blueprint': libraryBlueprint(),
        });
        expect(c.pending != null, mode == 'lost');
        expect(server.mutations.length, mode == 'storage' ? 0 : 1);
        if (mode == 'lost') {
          c.dispose();
          final recovered = TemplateOperation(t);
          await recovered.initialize();
          await recovered.retry();
          expect(recovered.pending, isNotNull);
          expect(server.mutations.length, 1);
          recovered.dispose();
        } else {
          c.dispose();
        }
        c.transport.close();
        t.close();
        f.scope.dispose();
        f.session.dispose();
      }
    },
  );
  test(
    'portable blueprint rejects unknown runtime fields, duplicate skills and invalid schedules',
    () {
      final unknown = libraryBlueprint()..['memory'] = 'secret';
      expect(() => blueprint(unknown), throwsA(anything));
      final duplicate = libraryBlueprint();
      final skills = duplicate['skills'] as List;
      skills.add(skills.first);
      expect(() => blueprint(duplicate), throwsA(anything));
      final schedule = libraryBlueprint();
      schedule['routines'][0]['schedule'] = 'daily:29:00';
      expect(() => blueprint(schedule), throwsA(anything));
      expect(librarySchedule('weekly:1,5:09:00'), true);
      expect(librarySchedule('weekly:1,1:09:00'), false);
    },
  );
}
