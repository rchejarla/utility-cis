import { config, library } from "@fortawesome/fontawesome-svg-core";
import "@fortawesome/fontawesome-svg-core/styles.css";

// Prevent FA from adding CSS automatically (Next.js handles it)
config.autoAddCss = false;

// Import icons you need — add more as needed
import {
  faHouse,
  faGauge,
  faLocationDot,
  faCircleNodes,
  faUser,
  faFileContract,
  faMoneyBill,
  faCalendarDays,
  faClipboardList,
  faPalette,
  faGear,
  faMagnifyingGlass,
  faPlus,
  faChevronLeft,
  faChevronRight,
  faSun,
  faMoon,
  faFilter,
  faTable,
  faMap,
  faDroplet,
  faBolt,
  faFire,
  faToilet,
  faCheck,
  faXmark,
  faArrowLeft,
  faEllipsisVertical,
  faChartLine,
  faWrench,
} from "@fortawesome/pro-solid-svg-icons";

import {
  faHouse as farHouse,
  faLocationDot as farLocationDot,
  faCircleNodes as farCircleNodes,
  faUser as farUser,
  faFileContract as farFileContract,
  faMoneyBill as farMoneyBill,
  faCalendarDays as farCalendarDays,
  faClipboardList as farClipboardList,
  faPalette as farPalette,
  faGear as farGear,
} from "@fortawesome/pro-regular-svg-icons";

library.add(
  faHouse, faGauge, faLocationDot, faCircleNodes, faUser, faFileContract,
  faMoneyBill, faCalendarDays, faClipboardList, faPalette, faGear,
  faMagnifyingGlass, faPlus, faChevronLeft, faChevronRight,
  faSun, faMoon, faFilter, faTable, faMap,
  faDroplet, faBolt, faFire, faToilet,
  faCheck, faXmark, faArrowLeft, faEllipsisVertical, faChartLine, faWrench,
  farHouse, farLocationDot, farCircleNodes, farUser, farFileContract,
  farMoneyBill, farCalendarDays, farClipboardList, farPalette, farGear,
);
