import 'dart:convert';

import 'package:flutter/services.dart';

import '../../core/api.dart';

export 'app_catalog_ids.g.dart';

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
