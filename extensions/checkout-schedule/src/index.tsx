import '@shopify/ui-extensions/preact';
import {render} from 'preact';

import {CheckoutSchedule} from './CheckoutSchedule';

export default function extension() {
  render(<CheckoutSchedule />, document.body);
}
