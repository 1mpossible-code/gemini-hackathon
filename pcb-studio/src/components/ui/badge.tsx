import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px font-mono text-[10.5px] uppercase tracking-[0.06em] tabular',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        outline: 'border-border text-muted-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
)

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
