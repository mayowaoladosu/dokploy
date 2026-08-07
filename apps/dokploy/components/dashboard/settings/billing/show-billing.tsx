import {
	ArrowUpRight,
	Bell,
	Check,
	CreditCard,
	Database,
	FileText,
	Gauge,
	Loader2,
	Minus,
	Plus,
	ShieldCheck,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

const navigationItems = [
	{
		name: "Subscription",
		href: "/dashboard/settings/billing",
		icon: CreditCard,
	},
	{
		name: "Orders & invoices",
		href: "/dashboard/settings/invoices",
		icon: FileText,
	},
];

const planCopy = {
	legacy: {
		label: "Legacy",
		eyebrow: "Original",
		features: ["Hosted deployments", "Managed PostgreSQL", "Usage reporting"],
	},
	hobby: {
		label: "Hobby",
		eyebrow: "For focused projects",
		features: [
			"Production deployments",
			"Managed PostgreSQL",
			"Metrics, logs, and traces",
		],
	},
	startup: {
		label: "Startup",
		eyebrow: "For shipping teams",
		features: [
			"Everything in Hobby",
			"Priority build capacity",
			"Higher platform limits",
		],
	},
} as const;

const formatMoney = (amount: number, currency: string) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.toUpperCase(),
		maximumFractionDigits: 2,
	}).format(amount / 100);

const formatDate = (value: string) =>
	new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	}).format(new Date(value));

const normalizeQuantity = (value: string, minimum: number) => {
	const parsed = Number.parseInt(value, 10);
	return Number.isSafeInteger(parsed)
		? Math.min(Math.max(parsed, minimum), 1_000)
		: minimum;
};

export const ShowBilling = () => {
	const router = useRouter();
	const { data, isPending, refetch } = api.polar.getBillingOverview.useQuery();
	const { mutateAsync: createCheckout, isPending: isCreatingCheckout } =
		api.polar.createCheckoutSession.useMutation();
	const { mutateAsync: createPortal, isPending: isCreatingPortal } =
		api.polar.createCustomerPortalSession.useMutation();
	const { mutateAsync: changeSubscription, isPending: isChangingSubscription } =
		api.polar.changeSubscription.useMutation();
	const { mutateAsync: updateNotifications } =
		api.polar.updateInvoiceNotifications.useMutation();
	const [isAnnual, setIsAnnual] = useState(false);
	const [quantities, setQuantities] = useState({ hobby: 1, startup: 3 });
	const [pendingTier, setPendingTier] = useState<
		"legacy" | "hobby" | "startup" | null
	>(null);

	useEffect(() => {
		if (router.query.success !== "true") return;
		toast.success("Checkout complete. Your subscription is being activated.");
		void refetch();
		void router.replace("/dashboard/settings/billing", undefined, {
			shallow: true,
		});
	}, [refetch, router]);

	useEffect(() => {
		if (!data?.subscription) return;
		setIsAnnual(data.subscription.interval === "year");
		setQuantities({
			hobby: Math.max(data.subscription.seats, 1),
			startup: Math.max(data.subscription.seats, 3),
		});
	}, [data?.subscription]);

	const visibleProducts = useMemo(
		() =>
			data?.products.filter(
				(product) => product.interval === (isAnnual ? "year" : "month"),
			) ?? [],
		[data?.products, isAnnual],
	);

	const openPortal = async () => {
		try {
			const session = await createPortal();
			window.location.assign(session.url);
		} catch {
			toast.error("The billing portal could not be opened.");
		}
	};

	const startCheckout = async (tier: "legacy" | "hobby" | "startup") => {
		if (data?.subscription) {
			setPendingTier(tier);
			try {
				await changeSubscription({
					tier,
					isAnnual,
					serverQuantity:
						tier === "startup" ? quantities.startup : quantities.hobby,
				});
				await refetch();
				toast.success("Subscription updated in Polar");
			} catch {
				toast.error("Subscription could not be updated.");
			} finally {
				setPendingTier(null);
			}
			return;
		}
		setPendingTier(tier);
		try {
			const session = await createCheckout({
				tier,
				isAnnual,
				serverQuantity:
					tier === "startup" ? quantities.startup : quantities.hobby,
			});
			window.location.assign(session.url);
		} catch {
			setPendingTier(null);
			toast.error("Checkout could not be created.");
		}
	};

	if (isPending) {
		return (
			<div className="flex min-h-[45vh] items-center justify-center">
				<div className="flex items-center gap-3 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					Loading billing state
				</div>
			</div>
		);
	}

	return (
		<div className="mx-auto w-full max-w-6xl space-y-6">
			<Card className="relative overflow-hidden border-border/70 bg-background shadow-sm">
				<div
					className="pointer-events-none absolute inset-0 opacity-[0.035] dark:opacity-[0.07]"
					style={{
						backgroundImage:
							"linear-gradient(to right,currentColor 1px,transparent 1px),linear-gradient(to bottom,currentColor 1px,transparent 1px)",
						backgroundSize: "28px 28px",
					}}
				/>
				<CardHeader className="relative flex flex-row items-start justify-between gap-4 border-b pb-5">
					<div className="space-y-2">
						<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
							<span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" />
							Account control
						</div>
						<CardTitle className="text-2xl tracking-tight">Billing</CardTitle>
						<CardDescription>
							Plans, usage access, and payment history are managed securely by
							Polar.
						</CardDescription>
					</div>
					{data?.subscription && (
						<Dialog>
							<DialogTrigger asChild>
								<Button
									variant="outline"
									size="icon"
									aria-label="Billing notifications"
								>
									<Bell className="size-4" />
								</Button>
							</DialogTrigger>
							<DialogContent className="sm:max-w-md">
								<DialogHeader>
									<DialogTitle>Billing notifications</DialogTitle>
									<DialogDescription>
										Receive payment confirmations and failed-payment alerts.
									</DialogDescription>
								</DialogHeader>
								<div className="flex items-center justify-between rounded-lg border p-4">
									<Label htmlFor="invoice-notifications" className="space-y-1">
										<span className="block">Email notifications</span>
										<span className="block text-xs font-normal text-muted-foreground">
											Sent to the organization owner.
										</span>
									</Label>
									<Switch
										id="invoice-notifications"
										checked={data.invoiceNotifications}
										onCheckedChange={async (enabled) => {
											try {
												await updateNotifications({ enabled });
												await refetch();
												toast.success("Notification preference updated");
											} catch {
												toast.error(
													"Notification preference could not be updated",
												);
											}
										}}
									/>
								</div>
							</DialogContent>
						</Dialog>
					)}
				</CardHeader>
				<CardContent className="relative pt-0">
					<nav className="flex gap-1 border-b pt-2">
						{navigationItems.map((item) => {
							const Icon = item.icon;
							const active = router.pathname === item.href;
							return (
								<Link
									key={item.href}
									href={item.href}
									className={cn(
										"flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors",
										active
											? "border-foreground text-foreground"
											: "border-transparent text-muted-foreground hover:text-foreground",
									)}
								>
									<Icon className="size-4" />
									{item.name}
								</Link>
							);
						})}
					</nav>
				</CardContent>
			</Card>

			{!data?.configured && (
				<Card className="border-amber-500/30 bg-amber-500/5">
					<CardContent className="flex items-start gap-3 p-5">
						<ShieldCheck className="mt-0.5 size-5 text-amber-600" />
						<div>
							<p className="font-medium">Billing is not configured</p>
							<p className="mt-1 text-sm text-muted-foreground">
								A platform operator must configure the Polar access token,
								webhook, and product IDs.
							</p>
						</div>
					</CardContent>
				</Card>
			)}

			{data?.isEnterpriseCloud ? (
				<Card className="border-emerald-500/30 bg-emerald-500/[0.04]">
					<CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
						<div className="flex items-start gap-4">
							<div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 p-2.5">
								<ShieldCheck className="size-5 text-emerald-600" />
							</div>
							<div>
								<p className="font-semibold">Enterprise Cloud</p>
								<p className="mt-1 text-sm text-muted-foreground">
									Your contract and limits are managed by the vlyv team.
								</p>
							</div>
						</div>
						{data.hasCustomer && (
							<Button
								variant="outline"
								onClick={openPortal}
								disabled={isCreatingPortal}
							>
								{isCreatingPortal ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<ArrowUpRight className="size-4" />
								)}
								Open billing portal
							</Button>
						)}
					</CardContent>
				</Card>
			) : data?.subscription ? (
				<Card className="overflow-hidden border-emerald-500/25">
					<div className="h-1 bg-emerald-500" />
					<CardContent className="grid gap-6 p-6 lg:grid-cols-[1.2fr_0.8fr]">
						<div className="space-y-4">
							<div className="flex flex-wrap items-center gap-2">
								<Badge className="bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400">
									{data.subscription.status}
								</Badge>
								<span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
									Current subscription
								</span>
							</div>
							<div>
								<h2 className="text-3xl font-semibold capitalize tracking-tight">
									{data.currentPlan || "Hosted"}
								</h2>
								<p className="mt-1 text-sm text-muted-foreground">
									{formatMoney(
										data.subscription.amount,
										data.subscription.currency,
									)}{" "}
									per {data.subscription.interval}
								</p>
							</div>
							<Button onClick={openPortal} disabled={isCreatingPortal}>
								{isCreatingPortal ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<ArrowUpRight className="size-4" />
								)}
								Manage in Polar
							</Button>
						</div>
						<div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border">
							<div className="bg-background p-4">
								<Gauge className="mb-3 size-4 text-muted-foreground" />
								<p className="text-xs text-muted-foreground">Capacity</p>
								<p className="mt-1 font-semibold">
									{data.managed
										? "Managed"
										: `${data.subscription.seats} server${
												data.subscription.seats === 1 ? "" : "s"
											}`}
								</p>
							</div>
							<div className="bg-background p-4">
								<Sparkles className="mb-3 size-4 text-muted-foreground" />
								<p className="text-xs text-muted-foreground">
									{data.subscription.cancelAtPeriodEnd
										? "Access until"
										: "Renews"}
								</p>
								<p className="mt-1 font-semibold">
									{formatDate(data.subscription.currentPeriodEnd)}
								</p>
							</div>
						</div>
					</CardContent>
				</Card>
			) : null}

			{data?.configured && !data.isEnterpriseCloud && (
				<section className="space-y-4">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
						<div>
							<p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
								Catalog
							</p>
							<h2 className="mt-1 text-xl font-semibold tracking-tight">
								{data.subscription ? "Explore your plan" : "Choose a plan"}
							</h2>
						</div>
						<Tabs
							value={isAnnual ? "annual" : "monthly"}
							onValueChange={(value) => setIsAnnual(value === "annual")}
						>
							<TabsList>
								<TabsTrigger value="monthly">Monthly</TabsTrigger>
								<TabsTrigger value="annual">Annual</TabsTrigger>
							</TabsList>
						</Tabs>
					</div>

					<div className="grid gap-4 lg:grid-cols-2">
						{visibleProducts
							.filter((product) => product.tier !== "legacy")
							.map((product) => {
								const copy = planCopy[product.tier];
								const quantity =
									product.tier === "startup"
										? quantities.startup
										: quantities.hobby;
								const seatTier = product.seatTiers.find(
									(tier) =>
										quantity >= tier.minSeats &&
										(tier.maxSeats === null || quantity <= tier.maxSeats),
								);
								const total =
									product.priceAmount == null
										? null
										: product.seatBased && !data.managed
											? (seatTier?.pricePerSeat ?? product.priceAmount) *
												quantity
											: product.priceAmount;
								const isCurrent =
									data.currentPlan === product.tier &&
									data.subscription?.interval === product.interval;
								const capacityUnchanged =
									data.managed ||
									!product.seatBased ||
									data.subscription?.seats === quantity;
								return (
									<Card
										key={product.id}
										className={cn(
											"relative overflow-hidden transition-colors",
											product.tier === "startup" && "border-foreground/30",
										)}
									>
										{product.tier === "startup" && (
											<div className="absolute right-0 top-0 rounded-bl-lg bg-foreground px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-background">
												Recommended
											</div>
										)}
										<CardHeader>
											<div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
												{product.tier === "startup" ? (
													<Sparkles className="size-3.5" />
												) : (
													<Database className="size-3.5" />
												)}
												{copy.eyebrow}
											</div>
											<CardTitle className="text-2xl">{copy.label}</CardTitle>
											<CardDescription className="min-h-10">
												{product.description ||
													"A production-ready vlyv subscription."}
											</CardDescription>
										</CardHeader>
										<CardContent className="space-y-5">
											<div>
												<span className="text-3xl font-semibold tracking-tight">
													{total == null
														? "Custom"
														: formatMoney(total, product.priceCurrency)}
												</span>
												<span className="ml-1 text-sm text-muted-foreground">
													/{isAnnual ? "year" : "month"}
												</span>
											</div>
											{product.seatBased && !data.managed && (
												<div className="flex items-center justify-between rounded-lg border bg-muted/30 p-3">
													<div>
														<p className="text-sm font-medium">Servers</p>
														<p className="text-xs text-muted-foreground">
															Billed as plan capacity
														</p>
													</div>
													<div className="flex items-center gap-2">
														<Button
															variant="outline"
															size="icon"
															className="size-8"
															disabled={
																quantity <= (product.tier === "startup" ? 3 : 1)
															}
															onClick={() =>
																setQuantities((current) => ({
																	...current,
																	[product.tier]: Math.max(
																		product.tier === "startup" ? 3 : 1,
																		quantity - 1,
																	),
																}))
															}
														>
															<Minus className="size-3.5" />
														</Button>
														<Input
															aria-label={`${copy.label} server quantity`}
															type="number"
															min={product.tier === "startup" ? 3 : 1}
															max={1000}
															className="h-8 w-16 text-center"
															value={quantity}
															onChange={(event) =>
																setQuantities((current) => ({
																	...current,
																	[product.tier]: normalizeQuantity(
																		event.target.value,
																		product.tier === "startup" ? 3 : 1,
																	),
																}))
															}
														/>
														<Button
															variant="outline"
															size="icon"
															className="size-8"
															onClick={() =>
																setQuantities((current) => ({
																	...current,
																	[product.tier]: Math.min(quantity + 1, 1000),
																}))
															}
														>
															<Plus className="size-3.5" />
														</Button>
													</div>
												</div>
											)}
											<ul className="space-y-2.5">
												{copy.features.map((feature) => (
													<li
														key={feature}
														className="flex items-center gap-2 text-sm"
													>
														<span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/10">
															<Check className="size-3 text-emerald-600" />
														</span>
														{feature}
													</li>
												))}
											</ul>
											<Button
												className="w-full"
												variant={
													product.tier === "startup" ? "default" : "outline"
												}
												disabled={
													isCreatingCheckout ||
													isChangingSubscription ||
													isCreatingPortal ||
													(isCurrent && capacityUnchanged)
												}
												onClick={() => startCheckout(product.tier)}
											>
												{pendingTier === product.tier ? (
													<Loader2 className="size-4 animate-spin" />
												) : data.subscription ? (
													<ArrowUpRight className="size-4" />
												) : (
													<CreditCard className="size-4" />
												)}
												{isCurrent && capacityUnchanged
													? "Current plan"
													: data.subscription
														? "Update subscription"
														: `Choose ${copy.label}`}
											</Button>
										</CardContent>
									</Card>
								);
							})}
					</div>
					<p className="text-center text-xs text-muted-foreground">
						Payments, tax calculation, invoices, and subscription changes are
						handled by Polar as merchant of record.
					</p>
				</section>
			)}
		</div>
	);
};
