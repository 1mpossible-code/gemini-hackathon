import * as React from 'react'
import { cn } from '@/lib/utils'

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] placeholder:text-faint transition-colors focus-visible:border-ring/60 focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
