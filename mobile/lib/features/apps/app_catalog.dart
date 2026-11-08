import 'dart:convert';

import 'package:flutter/services.dart';

import '../../core/api.dart';

const appProviderIds = {
  'notion',
  'linear',
  'github',
  'sentry',
  'atlassian',
  'slack',
  'gitlab',
  'microsoft-learn',
  'cloudflare-docs',
  'deepwiki',
};

Future<List<Json>> loadAppProviders() async =>
    (jsonDecode(await rootBundle.loadString('assets/apps/providers.json'))
            as List)
        .cast<Json>();

Json? findProviderConnection(Json provider, List<Json> apps) {
  String normalized(Object? address) =>
      (address as String? ?? '').replaceFirst(RegExp(r'/$'), '');
  final matches = apps.where(
    (app) => normalized(app['url']) == normalized(provider['url']),
  );
  return matches.where((app) => app['status'] == 'connected').firstOrNull ??
      matches.firstOrNull;
}
