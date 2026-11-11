export const MANUAL_TRADE_INPUT_EVENT = 'pokerun:manual-trade-input'
export const MANUAL_TRADE_RUNTIME_ERROR_EVENT = 'pokerun:manual-trade-runtime-error'

export type ManualTradeInputDetail = {
  code: string
  button: string
  pressed: boolean
  at: number
}

export type ManualTradeRuntimeErrorDetail = {
  source: 'boot' | 'window-error' | 'unhandled-rejection'
  message: string
  at: number
}
