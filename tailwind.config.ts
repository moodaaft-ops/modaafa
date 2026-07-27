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
        'fade-in-fast': 'fade-in 0.15s ease-out both',
        'fade-in': 'fade-in 0.25s ease-out both',
        'fade-up': 'fade-up 0.5s cubic-bezier(0.16,1,0.3,1) both',
        'typing-dot': 'typing-dot 1.2s ease-in-out infinite',
      },
      boxShadow: {
        // Elevation in a dark UI comes from an inner top highlight plus a very
        // soft ambient shadow — a plain drop shadow is invisible on near-black.
        soft: 'inset 0 1px 0 0 hsl(var(--edge-highlight)), 0 1px 2px 0 hsl(222 40% 2% / 0.35)',
        card: 'inset 0 1px 0 0 hsl(var(--edge-highlight)), 0 1px 2px 0 hsl(222 40% 2% / 0.4), 0 8px 24px -16px hsl(222 60% 2% / 0.6)',
        pop: 'inset 0 1px 0 0 hsl(var(--edge-highlight-strong)), 0 12px 32px -12px hsl(222 60% 2% / 0.75), 0 2px 8px -3px hsl(222 60% 2% / 0.55)',
        'glow-brand': '0 0 0 1px hsl(var(--primary) / 0.35), 0 10px 40px -12px hsl(var(--primary) / 0.5)',
        'focus-ring': '0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring))',
      },
      fontSize: {
        // Display sizes get tighter tracking and leading than Tailwind's
        // defaults; Arabic at 48px+ otherwise reads loose and unconfident.
        'display-sm': ['2rem', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
        'display-md': ['2.75rem', { lineHeight: '1.12', letterSpacing: '-0.028em' }],
        'display-lg': ['3.5rem', { lineHeight: '1.06', letterSpacing: '-0.032em' }],
        'display-xl': ['4.25rem', { lineHeight: '1.02', letterSpacing: '-0.036em' }],
      },
      fontFamily: {
        sans: ['var(--font-arabic)', 'sans-serif'],
      },
      colors: {
        border: {
          DEFAULT: 'hsl(var(--border) / <alpha-value>)',
          strong: 'hsl(var(--border-strong) / <alpha-value>)',
        },
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: {
          DEFAULT: 'hsl(var(--background) / <alpha-value>)',
          elevated: 'hsl(var(--background-elevated) / <alpha-value>)',
        },
        foreground: {
          DEFAULT: 'hsl(var(--foreground) / <alpha-value>)',
          subtle: 'hsl(var(--foreground-subtle) / <alpha-value>)',
        },
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
        // The primary button is a solid accent, not a gradient: gradients on
        // small controls read cheap, and a solid lets contrast be verified.
        'brand-gradient': 'linear-gradient(180deg, hsl(var(--primary)) 0%, hsl(var(--primary) / 0.88) 100%)',
        'brand-soft': 'linear-gradient(135deg, hsl(var(--primary) / 0.14) 0%, hsl(var(--primary) / 0.05) 100%)',
        'surface-grid': 'radial-gradient(hsl(var(--border) / 0.6) 1px, transparent 1px)',
      },
      transitionTimingFunction: {
        // Linear's easing: fast out, settled.
        snap: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
