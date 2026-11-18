import { Component, type ReactNode } from 'react';
import { Dialog } from './UI';
import { uiText } from '../i18n/account';

type Props = {
  children: ReactNode;
  onClose?: () => void;
  resetKey?: unknown;
  fallback?: ReactNode;
};

export class LoadBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    const refresh = (
      <button type="button" className="secondary-button" onClick={() => window.location.reload()}>
        {uiText('common:refresh')}
      </button>
    );
    if (this.props.onClose)
      return (
        <Dialog title={uiText('common:pageLoadFailed')} onClose={this.props.onClose}>
          {refresh}
        </Dialog>
      );
    return (
      <section className="loading-screen" role="alert">
        <p>{uiText('common:pageLoadFailed')}</p>
        {refresh}
      </section>
    );
  }
}
