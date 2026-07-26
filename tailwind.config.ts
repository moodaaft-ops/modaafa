import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      keyframes: {
        'loading-bar': {
          '0%': { transform: 'translateX(125%)' },
          '100%': { transform: 'translateX(-225%)' },
        },
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'typing-dot': {
          '0%, 60%, 100%': { opacity: '0.25', transform: 'translateY(0)' },
          '30%': { opacity: '1', transform: 'translateY(-2px)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(-100%)' },
        },
      },
      animation: {
        'loading-bar': 'loading-bar 1.1s ease-in-out infinite',
        'fade-in': 'fade-in 0.25s ease-out both',
        'fade-up': 'fade-up 0.5s cubic-bezier(0.16,1,0.3,1) both',
        'typing-dot': 'typing-dot 1.2s ease-in-out infinite',
      },
      boxShadow: {
        soft: '0 1px 2px 0 hsl(222 47% 11% / 0.04), 0 1px 3px 0 hsl(222 47% 11% / 0.06)',
        card: '0 1px 2px hsl(222 47% 11% / 0.04), 0 12px 28px -14px hsl(222 47% 11% / 0.16)',
        pop: '0 10px 34px -10px hsl(222 47% 11% / 0.22)',
        'glow-brand': '0 8px 30px -8px hsl(161 84% 30% / 0.45)',
      },
      fontFamily: {
        sans: ['var(--font-arabic)', 'sans-serif'],
      },
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        card: 'hsl(var(--card) / <alpha-value>)',
        surface: 'hsl(var(--surface) / <alpha-value>)',
        elevated: 'hsl(var(--elevated) / <alpha-value>)',
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        brand: {
          50: '#ECFDF5', 100: '#D1FAE5', 200: '#A7F3D0', 300: '#6EE7B7',
          400: '#34D399', 500: '#10B981', 600: '#059669', 700: '#047857',
          800: '#065F46', 900: '#064E3B',
        },
        ink: {
          50: '#F8FAFC', 100: '#E2E8F0', 200: '#CBD5E1', 300: '#94A3B8',
          400: '#64748B', 500: '#475569', 600: '#334155', 700: '#1E293B',
          800: '#0F172A', 900: '#020617',
        },
        signal: {
          blue: '#2563EB',
          amber: '#D97706',
          red: '#DC2626',
          violet: '#7C3AED',
        },
      },
      backgroundImage: {
        // Darkened from 39%/27%: white text on the old light stop measured ~2.6:1,
        // failing WCAG AA 4.5:1 on the app's primary button everywhere.
        'brand-gradient': 'linear-gradient(135deg, hsl(158 88% 26%) 0%, hsl(161 90% 19%) 100%)',
        'brand-soft': 'linear-gradient(135deg, hsl(158 84% 39% / 0.12) 0%, hsl(161 88% 27% / 0.06) 100%)',
        'surface-grid':
          'radial-gradient(hsl(var(--border) / 0.6) 1px, transparent 1px)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
