/** @type {import('tailwindcss').Config} */

const defaultTheme = require('tailwindcss/defaultTheme');

module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  prefix: 'htw-',
  theme: {
    fontFamily: {
      sans: ['Helvetica', 'Arial', 'sans-serif'],
      serif: ['Garamond', 'serif'],
      mono: ['Courier New', 'monospace'],
    },
    screens: {
      all: '1px',
      xs: '480px',
      ...defaultTheme.screens,
    },
    extend: {
      colors: {
        black: '#010101',
        white: '#ffffff',
        blue: {
          50: '#E6EDF9',
          100: '#CDDCF4',
          200: '#A7C2EC',
          300: '#82A8E4',
          400: '#5385D2',
          500: '#2764c1',
          600: '#1D4685',
          700: '#162A4A',
          800: '#11213B',
          900: '#0D192C',
        },
        beige: {
          100: '#F6F4F1',
          200: '#F5F2EF',
          300: '#F3F0ED',
          400: '#F2EEEB',
          500: '#F1EDE9',
          600: '#D8D5D1',
          700: '#C0BDBA',
          800: '#A8A5A3',
          900: '#908E8B',
        },
        red: {
          100: '#EBBAB8',
          200: '#DF8D8A',
          300: '#D25F5B',
          400: '#C5312C',
          500: '#BF1B15',
          600: '#AB1812',
          700: '#85120E',
          800: '#5F0D0A',
          900: '#390806',
        },
        green: {
          50: '#D3E3DB',
          100: '#BED5C9',
          200: '#93BAA6',
          300: '#679F82',
          400: '#3C835E',
          500: '#27764d',
          600: '#236A45',
          700: '#1F5E3D',
          800: '#17462E',
          900: '#0F2F1E',
        },
        pink: {
          50: '#FAEAF8',
          100: '#F2C1EA',
          200: '#EA98DC',
          300: '#E26ECE',
          400: '#DA45C0',
          500: '#D631B9',
          600: '#C02CA6',
          700: '#952281',
          800: '#6B185C',
          900: '#400E37',
        },
      },
      fontSize: {
        md: '0.95rem',
      },
      spacing: {
        88: '22rem',
        100: '26rem',
        112: '28rem',
        128: '32rem',
        144: '36rem',
      },
      borderRadius: {
        none: '0',
        sm: '0.2rem',
        DEFAULT: '0.3rem',
        md: '0.4rem',
        lg: '0.5rem',
        full: '9999px',
      },
      blur: {
        xs: '3px',
      },
      animation: {
        'pulse-slow': 'pulse 3s infinite cubic-bezier(.4,0,.6,1)',
      },
    },
  },
  plugins: [],
};
