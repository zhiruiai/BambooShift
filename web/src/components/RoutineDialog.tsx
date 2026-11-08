import './RoutineDialog.css';
import { RoutineDialogView } from './routines/RoutineDialogView';
import { useRoutineDialog } from './routines/useRoutineDialog';

export function RoutineDialog(props: Parameters<typeof useRoutineDialog>[0]) {
  const model = useRoutineDialog(props);
  return <RoutineDialogView {...model} />;
}
export { routineScheduleLabel } from '../routineLabels';
