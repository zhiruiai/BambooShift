import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

bool _registered = false;

void registerBundledLicenses() {
  if (_registered) return;
  _registered = true;
  LicenseRegistry.addLicense(() async* {
    yield LicenseEntryWithLineBreaks(const [
      'BoopFace eye-pose interpolation',
    ], await rootBundle.loadString('assets/licenses/boopface-LICENSE.txt'));
    yield LicenseEntryWithLineBreaks(const [
      'Open Bot Avatar',
    ], await rootBundle.loadString('assets/licenses/open-avatar-LICENSE.txt'));
    yield LicenseEntryWithLineBreaks(const [
      'Community GrokBot',
    ], await rootBundle.loadString('assets/licenses/grokbot-LICENSE.txt'));
  });
}
