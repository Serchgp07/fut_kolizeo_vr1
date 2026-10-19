/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        night: {
          950: '#05080f',
          900: '#0a0f1a',
          800: '#0f1726',
          700: '#16213a',
          600: '#1e2d4d',
        },
        pitch: {
          DEFAULT: '#00e676',
          dark: '#00b85c',
        },
        gold: '#ffc83d',
        card: {
          yellow: '#ffd400',
          red: '#ff3b4e',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'Impact', 'sans-serif'],
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 24px rgba(0, 230, 118, 0.25)',
        'glow-sm': '0 0 12px rgba(0, 230, 118, 0.2)',
      },
      backgroundImage: {
        'pitch-lines':
          'repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0px, rgba(255,255,255,0.025) 48px, transparent 48px, transparent 96px)',
        hero: 'radial-gradient(1200px 420px at 50% -10%, rgba(0,230,118,0.18), transparent 60%)',
      },
    },
  },
  plugins: [],
};
