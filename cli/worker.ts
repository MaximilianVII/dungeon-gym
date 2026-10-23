import { parentPort } from 'node:worker_threads'
import { scoreUnit, type EvalUnit } from './pool'

// Worker thread: score each unit it is sent and post the results back.
parentPort?.on('message', (msg: { units: EvalUnit[] }) => {
  parentPort?.postMessage({ results: msg.units.map(scoreUnit) })
})
