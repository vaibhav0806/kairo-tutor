import { useState } from 'react';
import Wheel from '@uiw/react-color-wheel';
import ShadeSlider from '@uiw/react-color-shade-slider';
import { hsvaToHex, hexToHsva, type HsvaColor } from '@uiw/color-convert';

// A real HSV wheel with a draggable handle (@uiw/react-color) + a value/lightness shade slider —
// any hue, direct-manipulation (beats Clicky's fixed swatches, §5). Reports a live hex up.
export function ColorWheel({
  value,
  onChange,
  size = 248,
}: {
  value: string;
  onChange: (hex: string) => void;
  size?: number;
}) {
  const [hsva, setHsva] = useState<HsvaColor>(() => hexToHsva(value));

  const update = (next: HsvaColor) => {
    setHsva(next);
    onChange(hsvaToHex(next));
  };

  return (
    <div className="ob-wheel">
      <Wheel
        color={hsva}
        width={size}
        height={size}
        onChange={(c) => update({ ...hsva, ...c.hsva })}
      />
      <ShadeSlider
        hsva={hsva}
        className="ob-wheel-slider"
        onChange={(shade) => update({ ...hsva, ...shade })}
      />
    </div>
  );
}
