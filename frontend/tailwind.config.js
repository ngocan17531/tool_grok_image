/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        appbg: '#141620',
        cardbg: '#1D2130',
        cardbgLight: '#262B3D',
        accentStart: '#0055FF',
        accentEnd: '#00D2FF',
        textSoft: '#8F9BB3',
      },
      boxShadow: {
        'soft': '0 25px 50px -12px rgba(0, 0, 0, 0.4)',
        'glow': '0 8px 25px -5px rgba(0, 210, 255, 0.4)',
        'inner-soft': 'inset 0 2px 4px 0 rgba(0, 0, 0, 0.2)',
      },
      backgroundImage: {
        'gradient-accent': 'linear-gradient(135deg, #0055FF 0%, #00D2FF 100%)',
      }
    },
  },
  plugins: [],
}
