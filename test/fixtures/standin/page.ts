/**
 * The stand-in's page script (`server.ts` bundles it): greet the host, count
 * presses of the button, and keep one header toggle whose state the driver
 * reads off `body[data-flag]`.
 */
import { connect } from 'kehikot-module-protocol/client'

const { id, origins } = (window as unknown as { __standin: { id: string; origins: string[] } }).__standin
let flag = false
let presses = 0

document.getElementById('press')!.addEventListener('click', () => {
  presses += 1
  document.getElementById('pressed')!.textContent = String(presses)
})

const header = () => [{ kind: 'toggle' as const, id: 'flag', label: 'Flag', checked: flag, agents: true }]
const connection = connect(
  id,
  {
    onHello: () => {
      document.getElementById('greeted')!.textContent = 'greeted'
      connection.header(header())
    },
    onPress: ({ item }) => {
      if (item !== 'flag') return 'no such item'
      flag = !flag
      document.body.dataset.flag = String(flag)
      connection.header(header())
    },
  },
  { origins },
)
connection.listen()
