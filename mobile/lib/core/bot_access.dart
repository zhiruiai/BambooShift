import 'api.dart';

bool isManagedBot(Json bot) => bot.containsKey('sharedBot');

bool botModelReady(Json? bot, Json? settings) {
  final configured = bot?['modelConfigured'];
  return configured is bool ? configured : settings?['configured'] == true;
}

bool botAvailable(Json? bot) {
  if (bot == null) return false;
  if (!isManagedBot(bot)) return true;
  final source = bot['sharedBot'];
  return source is Map &&
      source['status'] == 'active' &&
      source['available'] != false;
}
