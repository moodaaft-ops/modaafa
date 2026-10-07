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
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
      boxShadow: {
        // Identity is flat: separation comes from hairline borders. `pop` is a
        // 1px ring for floating layers, not a drop shadow.
        soft: 'none',
        card: 'none',
        pop: '0 0 0 1px hsl(var(--border-strong))',
        'focus-ring': '0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring))',
      },
      fontSize: {
        // Display sizes: NO negative tracking. Arabic is a connected script and
        // negative letter-spacing collides the joined glyphs; the confident look
        // comes from weight + tight leading, not from pulling letters together.
        'display-sm': ['2rem', { lineHeight: '1.22', letterSpacing: 'normal' }],
        'display-md': ['2.75rem', { lineHeight: '1.16', letterSpacing: 'normal' }],
        'display-lg': ['3.5rem', { lineHeight: '1.1', letterSpacing: 'normal' }],
        'display-xl': ['4.25rem', { lineHeight: '1.06', letterSpacing: 'normal' }],
      },
      borderRadius: {
        none: '0',
        sm: '0',
        DEFAULT: '0',
        md: '2px',
        lg: '2px',
        xl: '2px',
        '2xl': '4px',
        '3xl': '4px',
        full: '9999px',
      },
      fontFamily: {
        sans: ['var(--font-arabic)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-arabic)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
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
        // Identity v1.0 raw palette (use the semantic tokens above in product UI).
        brand: {
          navy: '#0E1426',
          paper: '#F4F2EC',
          slate: '#586174',
          signal: '#FBBC04',
        },
        signal: {
          DEFAULT: 'hsl(var(--signal) / <alpha-value>)',
          foreground: 'hsl(var(--signal-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          soft: 'hsl(var(--success-soft) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          soft: 'hsl(var(--warning-soft) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'hsl(var(--danger) / <alpha-value>)',
          soft: 'hsl(var(--danger-soft) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'hsl(var(--info) / <alpha-value>)',
          soft: 'hsl(var(--info-soft) / <alpha-value>)',
        },
        // Neutral scale derived from navy and slate, kept so existing ink-*
        // classes resolve to identity colours while screens migrate.
        ink: {
          50: '#F4F2EC', 100: '#E4E3DF', 200: '#CDCFD4', 300: '#9AA0AE',
          400: '#7A8294', 500: '#586174', 600: '#3F475A', 700: '#2A3144',
          800: '#171D31', 900: '#0E1426',
        },
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
