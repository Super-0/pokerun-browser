import type { MelonDsBridge } from '../../core/emulator/melonds/MelonDsBridge'

// White 2 US only, behind the native radio link's verified revision guard.
// Addresses and layouts are from the pinned pokebw2 reference in the runbook.
const netSystemPointer = 0x021418D8
const netStatePointer = 0x021418E4
const gflNetPointer = 0x021418F0 // sNet.pNet
const handleTableOffset = 0x70
const handleStride = 0x50
const handleStateOffset = 0x4A
const machineCount = 8
const negotiatedState = 5

type Reader = Pick<MelonDsBridge, 'read8' | 'read16' | 'read32'>

function validPointer(address: number, size: number) {
  return address >= 0x02000000 && address <= 0x02400000 - size && (address & 3) === 0
}

export async function readWhite2UnionNegotiation(reader: Reader) {
  const [gflNet, netState, netSystem] = await Promise.all([
    reader.read32(gflNetPointer), reader.read32(netStatePointer), reader.read32(netSystemPointer),
  ])
  if (!validPointer(gflNet, 0x354) || !validPointer(netState, 0x64) || !validPointer(netSystem, 0x1EE)) return null

  const serverHandle = gflNet + handleTableOffset + handleStride * machineCount
  const [states, negotiationPointers, stateFunction, sentMask, connectedMask, stopped, error] = await Promise.all([
    Promise.all(Array.from({ length: machineCount }, (_, id) =>
      reader.read8(gflNet + handleTableOffset + id * handleStride + handleStateOffset))),
    Promise.all(Array.from({ length: machineCount }, (_, id) => reader.read32(serverHandle + 8 + id * 4))),
    reader.read32(netState + 8),
    reader.read16(serverHandle + 0x40),
    reader.read16(netSystem + 0x1E4),
    reader.read8(netSystem + 0x1EA),
    reader.read8(netSystem + 0x1E9),
  ])
  if (states.some(state => state > 7) || !validPointer((stateFunction & ~3) >>> 0, 4)) return null
  const validNegotiations = await Promise.all(negotiationPointers.map(address =>
    validPointer(address, 16) ? reader.read8(address + 0xD) : 0))
  return {
    stateFunction: (stateFunction & ~1) >>> 0,
    states, negotiatedCount: states.filter(state => state === negotiatedState).length,
    receivedNegotiationMask: validNegotiations.reduce((mask, valid, id) => mask | ((valid === 1 ? 1 : 0) << id), 0),
    sentMask, connectedMask, stopped: Boolean(stopped), error: Boolean(error),
  }
}
