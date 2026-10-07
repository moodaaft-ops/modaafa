import Image from 'next/image';
import { cn } from '@/lib/utils';

/**
 * Identity v1.0 logo components. Light theme uses the navy artwork, dark uses
 * the reversed (paper) artwork; the swap is pure CSS so there is no flash.
 *
 * Minimum sizes from the guidelines: lockup 32px wide (24 recommended), symbol
 * 12px (24 for digital). Keep clear space of at least the symbol's small
 * square around either mark.
 */
const LOCKUP_RATIO = 974 / 229;

export function LogoMark({
  size = 32,
  alt = 'مُضاعِف',
  className,
  priority,
}: {
  size?: number;
  alt?: string;
  className?: string;
  priority?: boolean;
}) {
  return (
    <>
      <Image
        src="/brand/modaafa-symbol-primary.svg"
        alt={alt}
        width={size}
        height={size}
        priority={priority}
        className={cn('flex-shrink-0 dark:hidden', className)}
        style={{ width: size, height: size }}
      />
      <Image
        src="/brand/modaafa-symbol-reversed.svg"
        alt={alt}
        width={size}
        height={size}
        priority={priority}
        className={cn('hidden flex-shrink-0 dark:block', className)}
        style={{ width: size, height: size }}
        aria-hidden
      />
    </>
  );
}

export function LogoLockup({
  height = 32,
  alt = 'مُضاعِف',
  className,
  priority,
}: {
  height?: number;
  alt?: string;
  className?: string;
  priority?: boolean;
}) {
  const width = Math.round(height * LOCKUP_RATIO);
  return (
    <>
      <Image
        src="/brand/modaafa-lockup-primary.svg"
        alt={alt}
        width={width}
        height={height}
        priority={priority}
        className={cn('flex-shrink-0 dark:hidden', className)}
        style={{ width, height }}
      />
      <Image
        src="/brand/modaafa-lockup-reversed.svg"
        alt={alt}
        width={width}
        height={height}
        priority={priority}
        className={cn('hidden flex-shrink-0 dark:block', className)}
        style={{ width, height }}
        aria-hidden
      />
    </>
  );
}
