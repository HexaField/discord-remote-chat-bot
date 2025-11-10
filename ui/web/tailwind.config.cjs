/** @type {import('tailwindcss').Config} */
const path = require('path')
module.exports = {
  // enable class-based dark mode so we can control theme via the `dark` class
  darkMode: 'class',
  content: [path.resolve(__dirname, './index.html'), path.resolve(__dirname, './src/**/*.{ts,tsx}')],
  theme: {
    extend: {}
  },
  plugins: []
}
