#!/usr/bin/env python3
"""Derive OpenBot's web font from the pinned Noto Sans SC source."""

import argparse
import hashlib
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


SOURCE_SHA256 = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da'
FAMILY = 'OpenBot Sans SC'
NAMES = {
    1: FAMILY,
    2: 'Regular',
    3: f'{FAMILY} Regular 2.004',
    4: f'{FAMILY} Regular',
    6: 'OpenBotSansSC-Regular',
    16: FAMILY,
    17: 'Regular',
    18: f'{FAMILY} Regular',
    21: FAMILY,
    22: 'Regular',
    25: 'OpenBotSansSC',
}


def build(source, output):
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError('Noto Sans SC source checksum differs from the pinned revision')
    with TTFont(source, recalcTimestamp=False) as font:
        cmap = set(font.getBestCmap())
        instantiateVariableFont(font, {'wght': 400}, inplace=True)
        for record in font['name'].names:
            if record.nameID in NAMES:
                record.string = NAMES[record.nameID]
        font.flavor = 'woff2'
        font.save(output)
    with TTFont(output) as result:
        if set(result.getBestCmap()) != cmap:
            raise ValueError('The derived font changed the original character coverage')
        if result['OS/2'].usWeightClass != 400 or 'fvar' in result:
            raise ValueError('The derived font is not a regular static instance')
    print(f'{len(cmap)} code points, SHA-256 {hashlib.sha256(output.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    build(args.source, args.output)
