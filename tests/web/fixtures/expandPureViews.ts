import React from 'react';

/** Expand stateless view boundaries while leaving interactive component fixtures intact. */
export function expandPureViews(value: any): any {
  if (Array.isArray(value)) return value.map(expandPureViews);
  if (!React.isValidElement(value)) return value;
  const node = value as React.ReactElement<Record<string, any>>;
  if (typeof node.type === 'function' && node.type.name.endsWith('View')) {
    return expandPureViews((node.type as (props: any) => any)(node.props));
  }
  if (!('children' in node.props)) return node;
  return React.cloneElement(node, undefined, expandPureViews(node.props.children));
}
