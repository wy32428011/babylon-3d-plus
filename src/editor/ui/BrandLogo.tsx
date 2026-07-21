import zendingLogoOnDarkUrl from '../../assets/branding/zending-logo-on-dark.png';
import zendingLogoOnLightUrl from '../../assets/branding/zending-logo-on-light.png';

export const APPLICATION_NAME = 'ZENDING 3D EDITOR';

type BrandLogoProps = {
  className?: string;
  surface?: 'dark' | 'light';
};

/** 根据承载背景选择对应的 ZENDING 品牌图，避免深浅色界面出现对比度问题。 */
export function BrandLogo({ className, surface = 'dark' }: BrandLogoProps) {
  const sourceUrl = surface === 'light' ? zendingLogoOnLightUrl : zendingLogoOnDarkUrl;

  return <img alt="" aria-hidden="true" className={className} draggable={false} src={sourceUrl} />;
}
