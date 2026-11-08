class SelectedAttachment {
  const SelectedAttachment({
    required this.name,
    required this.size,
    required this.type,
    required this.openRead,
    this.receivedFromShare = false,
  });
  final String name, type;
  final int size;
  final Stream<List<int>> Function() openRead;
  final bool receivedFromShare;
}
