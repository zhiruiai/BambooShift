import 'dart:convert';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';
import 'package:yaml/yaml.dart';

// Preflight with the pinned YAML tokenizer so aliases never reach the loader.
// ignore: implementation_imports
import 'package:yaml/src/scanner.dart';
// ignore: implementation_imports
import 'package:yaml/src/token.dart';

const skillFileMaxBytes = 64 * 1024;
typedef SkillFilePicker = Future<XFile?> Function();
typedef SkillFileDraft = ({String name, String description, String content});

Future<XFile?> pickSkillMarkdown() => openFile(
  acceptedTypeGroups: const [
    XTypeGroup(
      label: 'Markdown',
      extensions: ['md'],
      mimeTypes: ['text/markdown', 'text/plain'],
      uniformTypeIdentifiers: [
        'net.daringfireball.markdown',
        'public.plain-text',
      ],
    ),
  ],
);

const _invalid = FormatException('Invalid skill document.');
final _closingDelimiter = RegExp(r'(?:^|\n)---(?=\n|$)');
final _controlCharacter = RegExp(r'[\x00-\x1f\x7f-\x9f\u2028\u2029]');

SkillFileDraft parseSkillMarkdown(List<int> bytes) {
  if (bytes.length > skillFileMaxBytes) throw _invalid;
  final text = utf8.decode(bytes).replaceAll('\r\n', '\n');
  if (!text.startsWith('---\n')) throw _invalid;
  final document = text.substring(4);
  final closing = _closingDelimiter.firstMatch(document);
  if (closing == null) throw _invalid;
  final header = document.substring(0, closing.start);
  final content = document.substring(closing.end).trim();

  try {
    final scanner = Scanner(header);
    var token = scanner.scan();
    while (token.type != TokenType.streamEnd) {
      if (token.type == TokenType.alias) {
        throw _invalid;
      }
      token = scanner.scan();
    }
    final yaml = loadYamlNode(header);
    if (yaml is! YamlMap) throw _invalid;
    final rawName = yaml['name'], rawDescription = yaml['description'];
    if (rawName is! String || rawDescription is! String) throw _invalid;
    final name = rawName.trim(), description = rawDescription.trim();
    if (name.isEmpty ||
        name.length > 100 ||
        _controlCharacter.hasMatch(name) ||
        description.isEmpty ||
        description.length > 1000 ||
        content.isEmpty ||
        content.length > 16000) {
      throw _invalid;
    }
    return (name: name, description: description, content: content);
  } on YamlException {
    throw _invalid;
  } on StackOverflowError {
    throw _invalid;
  }
}

Future<SkillFileDraft?> readSkillMarkdown(
  XFile file, {
  required bool Function() isCurrent,
}) async {
  if (!file.name.toLowerCase().endsWith('.md')) throw _invalid;
  final length = await file.length();
  if (!isCurrent()) return null;
  if (length <= 0 || length > skillFileMaxBytes) throw _invalid;
  final bytes = BytesBuilder(copy: false);
  await for (final chunk
      in file.openRead(0, length).timeout(const Duration(seconds: 15))) {
    if (!isCurrent()) return null;
    if (bytes.length + chunk.length > length) throw _invalid;
    bytes.add(chunk);
  }
  if (!isCurrent()) return null;
  if (bytes.length != length) throw _invalid;
  return parseSkillMarkdown(bytes.takeBytes());
}
