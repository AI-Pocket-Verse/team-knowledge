"use client";
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/cn";
import { tr } from "@/i18n";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn("fixed inset-0 z-50 bg-black/40", className)}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Set to false to opt out of the default hidden description when the
     *  caller renders its own <DialogDescription> child. */
    withDefaultDescription?: boolean;
  }
>(({ className, children, withDefaultDescription = true, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 grid w-[440px] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-line bg-white p-6 shadow-glassLg",
        className
      )}
      {...props}
    >
      {children}
      {/* Visually-hidden default description. Rendering DialogPrimitive.Description
          (no manual id) lets Radix auto-wire Content's `aria-describedby` to it,
          which both gives screen readers a description target and silences
          Radix's dev "Missing `Description`" warning. Opt out via
          withDefaultDescription={false} when the dialog supplies its own. */}
      {withDefaultDescription && (
        <DialogPrimitive.Description className="sr-only">{tr("shell.dialog.defaultDescription")}</DialogPrimitive.Description>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = "DialogContent";

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1", className)} {...props} />
);
export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold", className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";

// Visible dialog description. Pair with `withDefaultDescription={false}` on
// DialogContent when you want a real description in place of the hidden
// default. Radix auto-wires Content's `aria-describedby` to whichever
// DialogPrimitive.Description renders inside it.
export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted", className)} {...props} />
));
DialogDescription.displayName = "DialogDescription";
