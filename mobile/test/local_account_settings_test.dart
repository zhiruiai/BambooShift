import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openbot_mobile/features/settings/account_settings.dart';

import 'support.dart';
import 'widgets_test.dart' show testApp;

void main() {
  testWidgets(
    'local account keeps nickname but omits password and remote sessions',
    (tester) async {
      var requests = 0;
      final f = await fixture((_) async {
        requests++;
        return jsonResponse({});
      });
      f.session.user = {...f.session.user!, 'localOnly': true, 'email': ''};
      await tester.pumpWidget(testApp(AccountSettings(session: f.session)));
      await tester.pumpAndSettle();
      expect(find.text('Local workspace'), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
      expect(find.byIcon(Icons.logout), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Save'), findsOneWidget);
      expect(requests, 0);
      await tester.pumpWidget(const SizedBox());
      f.scope.dispose();
      f.session.dispose();
    },
  );
}
