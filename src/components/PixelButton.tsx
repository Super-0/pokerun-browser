import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' }>

export function PixelButton({ tone = 'primary', className = '', children, ...props }: Props) {
  return <button className={`pixel-button ${tone} ${className}`} {...props}>{children}</button>
}
