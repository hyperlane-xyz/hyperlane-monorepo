import React, { ChangeEvent } from 'react';

export type SelectOption = {
  display: string;
  value: string;
};

type Props = React.DetailedHTMLProps<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  HTMLSelectElement
> & {
  options: Array<SelectOption>;
  value: string;
  onValueSelect: (value: string) => void;
  classes?: string;
};

export function SelectField({
  options,
  value,
  onValueSelect,
  classes,
  ...passThruProps
}: Props) {
  const onChangeSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    onValueSelect(event?.target?.value || '');
  };

  return (
    <select
      className={`htw-rounded htw-border htw-border-gray-400 htw-bg-transparent htw-px-2 htw-py-1 htw-text-sm htw-font-light invalid:htw-text-gray-400 ${
        classes || ''
      }`}
      {...passThruProps}
      value={value}
      onChange={onChangeSelect}
    >
      {options.map((o, i) => (
        <option key={`option-${i}`} value={o.value}>
          {o.display}
        </option>
      ))}
    </select>
  );
}
