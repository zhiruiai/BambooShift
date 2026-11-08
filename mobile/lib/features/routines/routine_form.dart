import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../l10n/strings.dart';

class RoutineForm extends StatefulWidget {
  const RoutineForm({
    super.key,
    required this.initial,
    required this.enabled,
    required this.onChanged,
    this.webhookAllowed = false,
  });
  final Json initial;
  final bool enabled;
  final ValueChanged<Json> onChanged;
  final bool webhookAllowed;
  @override
  State<RoutineForm> createState() => _RoutineFormState();
}

class _RoutineFormState extends State<RoutineForm> {
  late Json draft;
  late String frequency;
  late TimeOfDay time;
  final Set<int> days = {};
  int minutes = 60;
  @override
  void initState() {
    super.initState();
    draft = Map.of(widget.initial);
    final schedule = draft['schedule'] as String? ?? 'daily:09:00';
    final parts = schedule.split(':');
    frequency = parts.first;
    if (frequency == 'weekly') days.addAll(parts[1].split(',').map(int.parse));
    if (frequency == 'interval') minutes = int.tryParse(parts[1]) ?? 60;
    time = frequency == 'interval' || frequency == 'webhook'
        ? const TimeOfDay(hour: 9, minute: 0)
        : TimeOfDay(
            hour: int.parse(parts[parts.length - 2]),
            minute: int.parse(parts.last),
          );
  }

  void change(String key, Object value) {
    setState(() => draft[key] = value);
    widget.onChanged(Map.of(draft));
  }

  void schedule() {
    final clock =
        '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';
    final sorted = days.toList()..sort();
    change('schedule', switch (frequency) {
      'interval' => 'interval:$minutes',
      'weekly' => 'weekly:${sorted.join(',')}:$clock',
      'webhook' => 'webhook',
      _ => 'daily:$clock',
    });
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      TextFormField(
        initialValue: draft['title'] as String? ?? '',
        enabled: widget.enabled,
        maxLength: 100,
        decoration: InputDecoration(labelText: context.tr('routineTitle')),
        validator: (value) =>
            (value ?? '').trim().isEmpty ? context.tr('required') : null,
        onChanged: (value) => change('title', value),
      ),
      TextFormField(
        initialValue: draft['prompt'] as String? ?? '',
        enabled: widget.enabled,
        minLines: 3,
        maxLines: 8,
        maxLength: 12000,
        decoration: InputDecoration(labelText: context.tr('routinePrompt')),
        validator: (value) =>
            (value ?? '').trim().isEmpty ? context.tr('required') : null,
        onChanged: (value) => change('prompt', value),
      ),
      DropdownButtonFormField<String>(
        initialValue: frequency,
        decoration: InputDecoration(labelText: context.tr('frequency')),
        items:
            [
                  'daily',
                  'weekly',
                  'interval',
                  if (widget.webhookAllowed || frequency == 'webhook')
                    'webhook',
                ]
                .map(
                  (value) => DropdownMenuItem(
                    value: value,
                    child: Text(
                      context.tr(
                        value == 'webhook' ? 'routineWebhookOnly' : value,
                      ),
                    ),
                  ),
                )
                .toList(),
        onChanged: widget.enabled
            ? (value) {
                setState(() {
                  frequency = value!;
                  if (frequency == 'weekly' && days.isEmpty) {
                    days.addAll([1, 2, 3, 4, 5]);
                  }
                });
                schedule();
              }
            : null,
      ),
      if (frequency == 'weekly')
        FormField<bool>(
          validator: (_) => days.isEmpty ? context.tr('chooseWeekday') : null,
          builder: (field) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 6,
                children: List.generate(
                  7,
                  (index) => FilterChip(
                    label: Text(context.tr('weekday${index + 1}')),
                    selected: days.contains(index + 1),
                    onSelected: widget.enabled
                        ? (yes) {
                            setState(() {
                              yes
                                  ? days.add(index + 1)
                                  : days.remove(index + 1);
                            });
                            schedule();
                            field.didChange(days.isNotEmpty);
                          }
                        : null,
                  ),
                ),
              ),
              if (field.hasError)
                Text(
                  field.errorText!,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                    fontSize: 12,
                  ),
                ),
            ],
          ),
        ),
      if (frequency == 'interval')
        TextFormField(
          initialValue: minutes.toString(),
          enabled: widget.enabled,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(labelText: context.tr('intervalMinutes')),
          validator: (value) {
            final n = int.tryParse(value ?? '');
            return n == null || n < 1 || n > 525600
                ? context.tr('intervalRange')
                : null;
          },
          onChanged: (value) {
            minutes = int.tryParse(value) ?? 0;
            schedule();
          },
        )
      else if (frequency != 'webhook')
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(context.tr('time')),
          trailing: Text(time.format(context)),
          onTap: widget.enabled
              ? () async {
                  final selected = await showTimePicker(
                    context: context,
                    initialTime: time,
                  );
                  if (mounted && widget.enabled && selected != null) {
                    setState(() => time = selected);
                    schedule();
                  }
                }
              : null,
        ),
      if (frequency == 'webhook')
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Text(context.tr('routineWebhookSetupAfterSave')),
        )
      else
        TextFormField(
          initialValue: draft['timeZone'] as String? ?? 'Asia/Shanghai',
          enabled: widget.enabled,
          decoration: InputDecoration(
            labelText: context.tr('timeZone'),
            helperText: context.tr('routineZone'),
          ),
          validator: (value) =>
              (value ?? '').trim().isEmpty ? context.tr('required') : null,
          onChanged: (value) => change('timeZone', value.trim()),
        ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(
          context.tr(
            frequency == 'webhook' ? 'routineWebhookEnabled' : 'routineEnabled',
          ),
        ),
        value: draft['enabled'] == true,
        onChanged: widget.enabled ? (value) => change('enabled', value) : null,
      ),
    ],
  );
}
