import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @mockstock/shared 를 TS 소스 그대로 컴파일 (모노레포 공용 계약, 빌드 스텝 없음)
  transpilePackages: ["@mockstock/shared"],
};

export default nextConfig;
