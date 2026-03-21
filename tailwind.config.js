/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        // Deep background palette
        background: {
          DEFAULT: '#0f0f0f',
          secondary: '#141414',
          tertiary: '#1a1a1a',
          elevated: '#1f1f1f'
        },
        // Dark red accent palette
        accent: {
          50:  '#fff1f1',
          100: '#ffd7d7',
          200: '#ffb3b3',
          300: '#ff8080',
          400: '#ff4d4d',
          500: '#dc2626',
          600: '#b91c1c',
          700: '#991b1b',
          800: '#7f1d1d',
          900: '#8b0000',
          950: '#450a0a'
        },
        // Surface colors for cards, inputs
        surface: {
          DEFAULT: '#1c1c1c',
          hover: '#242424',
          active: '#2a2a2a',
          border: '#2d2d2d'
        },
        // Text hierarchy
        content: {
          primary: '#f5f5f5',
          secondary: '#a3a3a3',
          tertiary: '#6b6b6b',
          muted: '#404040'
        }
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Display',
          'SF Pro Text',
          'system-ui',
          'sans-serif'
        ],
        mono: [
          'SF Mono',
          'Fira Code',
          'Fira Mono',
          'Roboto Mono',
          'ui-monospace',
          'monospace'
        ]
      },
      animation: {
        'pulse-red': 'pulse-red 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
        'shimmer': 'shimmer 2s linear infinite',
        'fade-in': 'fade-in 0.3s ease-out',
        'slide-up': 'slide-up 0.3s ease-out'
      },
      keyframes: {
        'pulse-red': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' }
        },
        'glow': {
          'from': { boxShadow: '0 0 8px #dc2626, 0 0 16px #dc262640' },
          'to':   { boxShadow: '0 0 16px #dc2626, 0 0 32px #dc262660' }
        },
        'shimmer': {
          '0%': { backgroundPosition: '-1000px 0' },
          '100%': { backgroundPosition: '1000px 0' }
        },
        'fade-in': {
          'from': { opacity: '0' },
          'to': { opacity: '1' }
        },
        'slide-up': {
          'from': { opacity: '0', transform: 'translateY(8px)' },
          'to': { opacity: '1', transform: 'translateY(0)' }
        }
      },
      boxShadow: {
        'red-glow': '0 0 12px rgba(220, 38, 38, 0.4)',
        'red-glow-lg': '0 0 24px rgba(220, 38, 38, 0.5)',
        'surface': '0 1px 3px rgba(0, 0, 0, 0.5), 0 1px 2px rgba(0, 0, 0, 0.4)',
        'surface-lg': '0 4px 12px rgba(0, 0, 0, 0.6)'
      }
    }
  },
  plugins: [
    require('@tailwindcss/typography')
  ]
}
