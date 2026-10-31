import { Outlet } from 'react-router-dom'
import Header from './Header'
import BottomNav from './BottomNav'

export default function Layout() {
  return (
    <div className="min-h-screen bg-surface-50 flex flex-col">
      <Header />
      <main className="flex-1 pb-20 px-4 py-4 max-w-md mx-auto w-full">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  )
}
