import type {ComponentChildren} from 'preact';

type CheckoutElementChildren = {
  children?: ComponentChildren;
};

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      's-banner': CheckoutElementChildren & {
        tone?: 'info' | 'success' | 'warning' | 'critical';
      };
      's-text': CheckoutElementChildren & {
        emphasis?: 'bold';
      };
    }
  }
}
