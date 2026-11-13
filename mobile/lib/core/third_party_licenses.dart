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
  });
}
