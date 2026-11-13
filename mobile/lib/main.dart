import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'app.dart';
import 'core/api.dart';
import 'core/app_session.dart';
import 'core/secure_store.dart';
import 'core/third_party_licenses.dart';
import 'features/bots/avatar_camera.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  registerBundledLicenses();
  unawaited(discardAbandonedAvatarPhotos());
  if (kIsWeb) {
    try {
      final font = FontLoader(openBotWebCjkFontFamily);
      font.addFont(rootBundle.load('assets/fonts/OpenBotSansSC-Regular.woff2'));
      await font.load().timeout(const Duration(seconds: 15));
    } catch (_) {
      debugPrint('OpenBot web font could not be loaded.');
    }
  }
  runApp(
    OpenBotApp(
      session: AppSession(ApiClient(SessionVault(DeviceSecretStore()))),
    ),
  );
}
