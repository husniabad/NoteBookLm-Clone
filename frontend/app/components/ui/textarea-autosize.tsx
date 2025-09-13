'use client';

import * as React from 'react';
import { cn } from '@/app/lib/utils';

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

type Style = Omit<NonNullable<TextareaProps['style']>, 'maxHeight' | 'minHeight'> & {
  height?: number;
};

export type TextareaHeightChangeMeta = {
  rowHeight: number;
};

export interface TextareaAutosizeProps extends Omit<TextareaProps, 'style'> {
  maxRows?: number;
  minRows?: number;
  onHeightChange?: (height: number, meta: TextareaHeightChangeMeta) => void;
  cacheMeasurements?: boolean;
  style?: Style;
}

const TextareaAutosize = React.forwardRef<HTMLTextAreaElement, TextareaAutosizeProps>(
  ({ className, maxRows = 5, minRows = 1, onHeightChange, style, ...props }, ref) => {
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const [rowHeight, setRowHeight] = React.useState(0);

    React.useImperativeHandle(ref, () => textareaRef.current!);

    const resizeTextarea = React.useCallback(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      // Reset height to auto to get the correct scrollHeight
      textarea.style.height = 'auto';
      
      const computedStyle = window.getComputedStyle(textarea);
      const lineHeight = parseInt(computedStyle.lineHeight) || 20;
      
      if (rowHeight === 0) {
        setRowHeight(lineHeight);
      }

      const minHeight = lineHeight * minRows;
      const maxHeight = lineHeight * maxRows;
      const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
      
      textarea.style.height = `${newHeight}px`;
      
      if (onHeightChange) {
        onHeightChange(newHeight, { rowHeight: lineHeight });
      }
    }, [maxRows, minRows, onHeightChange, rowHeight]);

    React.useEffect(() => {
      resizeTextarea();
    }, [props.value, resizeTextarea]);

    return (
      <textarea
        ref={textareaRef}
        className={cn(
          "flex min-h-[40px] w-full bg-transparent px-3 py-3 text-sm placeholder:text-muted-foreground focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 resize-none overflow-hidden leading-normal",
          className
        )}
        style={{
          ...style,
          minHeight: rowHeight ? `${rowHeight * minRows}px` : undefined,
          maxHeight: rowHeight ? `${rowHeight * maxRows}px` : undefined,
        }}
        onInput={resizeTextarea}
        {...props}
      />
    );
  }
);

TextareaAutosize.displayName = 'TextareaAutosize';

export default TextareaAutosize;