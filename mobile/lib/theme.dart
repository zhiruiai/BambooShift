import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

const openBotWebCjkFontFamily = 'OpenBot Sans SC';

ThemeData openBotTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final colors =
      ColorScheme.fromSeed(
        seedColor: const Color(0xff76568d),
        brightness: brightness,
      ).copyWith(
        primary: Color(dark ? 0xffc8afe7 : 0xff76568d),
        surface: Color(dark ? 0xff1e1c24 : 0xffffffff),
        onSurface: Color(dark ? 0xfff0edf5 : 0xff29252f),
        outlineVariant: Color(dark ? 0xff41394d : 0xffe8e3ed),
      );
  final base = ThemeData(
    useMaterial3: true,
    colorScheme: colors,
    brightness: brightness,
    fontFamilyFallback: kIsWeb ? const [openBotWebCjkFontFamily] : null,
  );
  return base.copyWith(
    scaffoldBackgroundColor: Color(dark ? 0xff141318 : 0xfff4f5f6),
    textTheme: base.textTheme.copyWith(
      labelSmall: base.textTheme.labelSmall?.copyWith(fontSize: 12),
      bodySmall: base.textTheme.bodySmall?.copyWith(fontSize: 12),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: Color(dark ? 0xff141318 : 0xfff4f5f6),
      scrolledUnderElevation: 0,
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      margin: const EdgeInsets.symmetric(vertical: 6),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(18),
        side: BorderSide(color: colors.outlineVariant),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: colors.surface,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: BorderSide(color: colors.outlineVariant),
      ),
      helperStyle: const TextStyle(fontSize: 12),
      errorStyle: const TextStyle(fontSize: 12),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
    tooltipTheme: const TooltipThemeData(
      textStyle: TextStyle(fontSize: 12, color: Colors.white),
    ),
  );
}
