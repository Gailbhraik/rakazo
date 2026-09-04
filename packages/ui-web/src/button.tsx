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
        default: "bg-[#E0393E] text-white hover:bg-[#F2585C]",
        surface: "bg-[#171110] text-[#FBFBF9] hover:bg-[#2F2422]",
        cream: "bg-[#F1EFEF] text-[#1D1614] hover:opacity-90",
        outline: "border border-[#2F2321] text-[#EEECEC] hover:bg-[#201817]",
        ghost: "text-[#D0C8C7] hover:bg-[#171211]",
        pill: "rounded-full bg-[#221A18] text-[#F3F2F2] hover:bg-[#2F2422] hover:scale-[1.04]",
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
