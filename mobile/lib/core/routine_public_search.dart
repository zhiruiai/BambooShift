import 'api.dart' show Json;

const routinePublicSearchField = 'publicSearchQueries';
final _controlCharacter = RegExp(r'[\x00-\x1f\x7f-\x9f]');

List<String>? normalizeRoutinePublicQueries(Object? value) {
  if (value is! List || value.length > 4) return null;
  final phrases = <String>[];
  final unique = <String>{};
  for (final item in value) {
    if (item is! String) return null;
    final phrase = item.trim();
    if (phrase.isEmpty ||
        phrase.length > 160 ||
        _controlCharacter.hasMatch(phrase) ||
        !unique.add(phrase)) {
      return null;
    }
    phrases.add(phrase);
  }
  return List.unmodifiable(phrases);
}

bool routinePublicSearchConfigValid(Json config) =>
    !config.containsKey(routinePublicSearchField) ||
    normalizeRoutinePublicQueries(config[routinePublicSearchField]) != null;
