import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/apps/remote_mcp_import.dart';

Map<String, Object?> project(String source) {
  final result = parseRemoteMcpImport(source);
  return result.error != null
      ? {'ok': false, 'reason': result.error}
      : {
          'ok': true,
          'candidates': [
            for (final entry in result.candidates)
              {'name': entry.name, 'url': entry.url},
          ],
          'skipped': result.skipped,
        };
}

String configuration(String name, String url) => jsonEncode({
  'servers': {
    name: {'url': url},
  },
});

void main() {
  final fixture =
      jsonDecode(
            File(
              '../shared/fixtures/remote-mcp-import.json',
            ).readAsStringSync(),
          )
          as Map<String, dynamic>;
  for (final item in fixture['cases']) {
    test('shared local projection: ${item['name']}', () {
      final result = project(item['source'] ?? jsonEncode(item['input']));
      expect(result, item['projectionExpected']);
      expect(jsonEncode(result), isNot(contains('SYNTHETIC_')));
    });
  }
  for (final item in fixture['addresses']) {
    test('shared raw address projection: ${item['name']}', () {
      expect(
        project(configuration('fixture', item['input'])),
        item['projected']
            ? {
                'ok': true,
                'candidates': [
                  {'name': 'fixture', 'url': item['input']},
                ],
                'skipped': 0,
              }
            : {'ok': false, 'reason': 'empty'},
      );
    });
  }
  test(
    'UTF16 and UTF8 boundaries match the shared contract without truncation',
    () {
      final limits = fixture['limits'];
      final sourceLimit = limits['sourceUtf16'] as int;
      expect(maxMcpImportLength, sourceLimit);
      final source = configuration('fixture', 'https://example.com/mcp');
      expect(project(source.padRight(sourceLimit))['ok'], true);
      expect(project(source.padRight(sourceLimit + 1)), {
        'ok': false,
        'reason': 'size',
      });
      final entries = {
        for (var i = 0; i < limits['servers']; i++)
          '$i': {'url': 'https://example.com/$i'},
      };
      expect(project(jsonEncode({'servers': entries}))['ok'], true);
      entries['extra'] = {'url': 'https://example.com/extra'};
      expect(project(jsonEncode({'servers': entries})), {
        'ok': false,
        'reason': 'count',
      });
      final nameLimit = limits['nameUtf16'] as int;
      for (final name in ['x' * nameLimit, '🐼' * (nameLimit ~/ 2)]) {
        expect(
          project(configuration(name, 'https://example.com/'))['ok'],
          true,
        );
        expect(project(configuration('${name}x', 'https://example.com/')), {
          'ok': false,
          'reason': 'empty',
        });
      }
      final url = 'https://example.com/'.padRight(limits['urlUtf8'], 'a');
      expect(project(configuration('fixture', url))['ok'], true);
      for (final value in ['${url}a', 'https://example.com/${'汉' * 700}']) {
        expect(project(configuration('fixture', value)), {
          'ok': false,
          'reason': 'empty',
        });
      }
    },
  );
  test('invalid names and transports match the shared contract', () {
    for (final name in fixture['invalidNames']) {
      expect(project(configuration(name, 'https://example.com/')), {
        'ok': false,
        'reason': 'empty',
      });
    }
    for (final type in fixture['invalidTransports']) {
      for (final field in ['type', 'transport']) {
        expect(
          project(
            jsonEncode({
              'servers': {
                'fixture': {'url': 'https://example.com/', field: type},
              },
            }),
          ),
          {'ok': false, 'reason': 'empty'},
        );
      }
    }
  });
  test(
    'a projection is immutable and leaves IDNA and percent escapes to server preview',
    () {
      final result = parseRemoteMcpImport(
        configuration('fixture', 'https://bücher.example/%7e'),
      );
      expect(result.candidates.single.url, 'https://bücher.example/%7e');
      expect(() => result.candidates.clear(), throwsUnsupportedError);
    },
  );
}
