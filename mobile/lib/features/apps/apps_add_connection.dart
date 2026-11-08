part of 'apps_controller.dart';

extension _AppsConnectionCreation on AppsController {
  Future<Object?> _addConnection(Json input, String? reviewedEndpoint) async {
    Json body;
    try {
      body = addConnectionBody(input);
      if (reviewedEndpoint != null &&
          (!scope.personalOwner || body['url'] != reviewedEndpoint)) {
        throw const ApiException('INVALID_APP', 'mobileAppsInvalid');
      }
    } catch (_) {
      _rejectInvalidConnection();
      return null;
    }
    return _mutate(
      {'kind': 'add', 'fingerprint': appFingerprint(body)},
      'POST',
      '/apps',
      body,
      recover: reviewedEndpoint == null
          ? null
          : (cause, marker) =>
                _recoverDuplicate(cause, marker, reviewedEndpoint),
    );
  }

  Future<Object?> _recoverDuplicate(
    Object cause,
    Json marker,
    String url,
  ) async {
    if (cause is! ApiException ||
        cause.status != 409 ||
        cause.code != 'APP_CONNECTION_EXISTS') {
      return null;
    }
    try {
      guard();
      // The server rejected this add before writing or probing the endpoint.
      await pendingChecks.resolve(marker);
      guard();
      await _load(null);
      guard();
      return scope.personalOwner ? findExactMcpConnection(url, apps) : null;
    } catch (_) {
      return null;
    }
  }
}
