export enum ColorPalette {
  Black = '#010101',
  White = '#FFFFFF',
  Blue = '#2362C0',
  DarkBlue = '#162A4A',
  LightBlue = '#82A8E4',
  Pink = '#CF2FB3',
  LightGray = '#D3D4D7',
  Gray = '#6B7280',
  Beige = '#F1EDE9',
  Red = '#BF1B15',
}

export function seedToBgColor(seed?: number) {
  if (!seed) return 'htw-bg-gray-100';
  const mod = seed % 5;
  switch (mod) {
    case 0:
      return 'htw-bg-blue-100';
    case 1:
      return 'htw-bg-pink-200';
    case 2:
      return 'htw-bg-green-100';
    case 3:
      return 'htw-bg-orange-200';
    case 4:
      return 'htw-bg-violet-200';
    default:
      return 'htw-bg-gray-100';
  }
}
