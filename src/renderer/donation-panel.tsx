import { Heart, X } from 'lucide-react';
import paymentCode from './assets/wechat-payment.jpg';

export function DonationPanel() {
  return <main className="donation-panel">
    <button className="donation-close" aria-label="关闭打赏窗口" onClick={() => window.close()}><X size={20} /></button>
    <div className="donation-heart"><Heart size={24} /></div>
    <h1>打赏作者</h1>
    <p className="donation-intro">如果工作站帮到了你，欢迎支持作者。</p>
    <img className="donation-code" src={paymentCode} alt="作者微信收款码" />
    <p className="donation-scan">打开微信扫一扫，自愿打赏，金额随心</p>
    <p className="donation-thanks">感谢你的支持 ❤️</p>
  </main>;
}
