import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class Strings {
  Strings(this.locale, this.values);
  final Locale locale;
  final Map<String, dynamic> values;
  String text(String key) => values[key] as String? ?? key;
  static const delegate = _StringsDelegate();
  static const supported = [Locale('zh'), Locale('en')];
  static const catalogs = [
    'app',
    'avatars',
    'models',
    'apps',
    'workspace',
    'collaboration',
    'knowledge',
    'files',
    'computer',
    'library',
    'teaching',
    'roster',
    'device',
    'search',
    'voice',
  ];
}

class _StringsDelegate extends LocalizationsDelegate<Strings> {
  const _StringsDelegate();
  @override
  bool isSupported(Locale locale) => ['zh', 'en'].contains(locale.languageCode);
  @override
  Future<Strings> load(Locale locale) async {
    final values = <String, dynamic>{};
    for (final catalog in Strings.catalogs) {
      final data = await rootBundle.loadString(
        'assets/l10n/${catalog}_${locale.languageCode}.arb',
      );
      final entries = jsonDecode(data) as Map<String, dynamic>;
      for (final entry in entries.entries) {
        if (!entry.key.startsWith('@') && values.containsKey(entry.key)) {
          throw FormatException('Duplicate translation key: ${entry.key}');
        }
        values[entry.key] = entry.value;
      }
    }
    return Strings(locale, values);
  }

  @override
  bool shouldReload(_StringsDelegate old) => false;
}

extension LocalizedContext on BuildContext {
  String tr(String key) => Localizations.of<Strings>(this, Strings)!.text(key);
}
