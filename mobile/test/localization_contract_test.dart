import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/core/avatar_preferences.dart';
import 'package:openbot_mobile/l10n/strings.dart';

void main() {
  test(
    'Chinese and English resources cover static and runtime label families',
    () {
      final resources = <String, Map<String, dynamic>>{
        for (final language in ['zh', 'en'])
          language: {
            for (final catalog in Strings.catalogs)
              ...jsonDecode(
                    File(
                      'assets/l10n/${catalog}_$language.arb',
                    ).readAsStringSync(),
                  )
                  as Map<String, dynamic>,
          },
      };
      Set<String> keys(Map<String, dynamic> values) =>
          values.keys.where((k) => !k.startsWith('@')).toSet();
      expect(keys(resources['zh']!), keys(resources['en']!));
      final required = <String>{
        for (final state in [
          'running',
          'completed',
          'error',
          'cancelled',
          'interrupted',
        ])
          'run_$state',
        for (final state in [
          'submitted',
          'completed',
          'error',
          'cancelled',
          'interrupted',
        ])
          'routineReceipt_$state',
        'trigger_manual',
        'trigger_scheduled',
        for (var day = 1; day <= 7; day++) 'weekday$day',
        'owner',
        'member',
        'system',
        'light',
        'dark',
        ...avatarThemes,
      };
      final calls = RegExp(r"(?:\.tr|Notice)\(\s*'([A-Za-z][A-Za-z0-9_]*)'");
      for (final file
          in Directory('lib')
              .listSync(recursive: true)
              .whereType<File>()
              .where((f) => f.path.endsWith('.dart'))) {
        required.addAll(
          calls.allMatches(file.readAsStringSync()).map((m) => m[1]!),
        );
      }
      for (final language in resources.entries) {
        for (final key in required) {
          expect(
            language.value[key],
            isA<String>(),
            reason: '${language.key}: $key',
          );
          expect(
            (language.value[key] as String).trim(),
            isNotEmpty,
            reason: key,
          );
        }
      }
    },
  );

  test('owned explicit text sizes remain at least twelve', () {
    final sizes = RegExp(r'fontSize\s*:\s*(\d+(?:\.\d+)?)');
    for (final file
        in Directory('lib')
            .listSync(recursive: true)
            .whereType<File>()
            .where((f) => f.path.endsWith('.dart'))) {
      for (final match in sizes.allMatches(file.readAsStringSync())) {
        expect(
          double.parse(match[1]!),
          greaterThanOrEqualTo(12),
          reason: file.path,
        );
      }
    }
  });
}
