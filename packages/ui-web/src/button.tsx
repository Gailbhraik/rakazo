import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[13px] text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // L'action principale porte le rouge de marque ; les autres variantes
        // restent des surfaces neutres, sans quoi le signal se noierait.
        default: "bg-[var(--rk-a17)] text-white hover:bg-[var(--rk-a13)]",
        surface: "bg-[var(--rk-n91)] text-[var(--rk-n01)] hover:bg-[var(--rk-n61)]",
        cream: "bg-[var(--rk-n06)] text-[var(--rk-n83)] hover:opacity-90",
        outline: "border border-[var(--rk-n62)] text-[var(--rk-n08)] hover:bg-[var(--rk-n80)]",
        ghost: "text-[var(--rk-n18)] hover:bg-[var(--rk-n90)]",
        pill: "rounded-full bg-[var(--rk-n76)] text-[var(--rk-n03)] hover:bg-[var(--rk-n61)] hover:scale-[1.04]",
      },
      size: {
        default: "h-10 px-4",
        sm: "h-8 px-3 text-[13px]",
        lg: "h-12 px-6 text-[17px]",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
