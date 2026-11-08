import './Admin.css';
import { AdminWorkspaceView } from './workspace/AdminWorkspaceView';
import { useAdminWorkspace } from './workspace/useAdminWorkspace';
export default function AdminApp() {
  return <AdminWorkspace />;
}
function AdminWorkspace() {
  const model = useAdminWorkspace();
  return <AdminWorkspaceView {...model} />;
}
