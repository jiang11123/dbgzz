import { Heart, X } from 'lucide-react';
import paymentCode from './assets/wechat-payment.jpg';

export function DonationPanel() {
  return <main className="donation-panel">
    <button className="donation-close" aria-label="关闭赞赏窗口" onClick={() => window.close()}><X size={20} /></button>
    <div className="donation-heart"><Heart size={24} /></div>
    <h1>赞赏奶蛙老师</h1>
    <p className="donation-intro">如果工作站帮到了你，欢迎支持奶蛙老师。</p>
    <img className="donation-code" src={paymentCode} alt="奶蛙老师微信收款码" />
    <p className="donation-scan">打开微信扫一扫，自愿赞赏，金额随心</p>
    <p className="donation-thanks">感谢你的支持 ❤️</p>
  </main>;
}
