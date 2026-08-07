import InvoiceNotificationEmail from "@dokploy/server/emails/emails/invoice-notification";
import PaymentFailedEmail from "@dokploy/server/emails/emails/payment-failed";
import { sendEmail } from "@dokploy/server/verification/send-verification-email";
import type { models, Polar } from "@polar-sh/sdk/2026-04";
import { render } from "@react-email/components";
import { format } from "date-fns";

const formatAmount = (amountInCents: number, currency: string) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.toUpperCase(),
	}).format(amountInCents / 100);

const downloadPdf = async (url: string): Promise<Buffer | null> => {
	try {
		const documentUrl = new URL(url);
		if (
			documentUrl.protocol !== "https:" ||
			documentUrl.username ||
			documentUrl.password
		) {
			return null;
		}
		const response = await fetch(url, {
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) return null;
		const maximumBytes = 20 * 1024 * 1024;
		const contentLength = Number(response.headers.get("content-length") || "0");
		if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
			return null;
		}
		if (!response.body) return null;
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let received = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > maximumBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
	} catch {
		return null;
	}
};

export const sendPolarOrderPaidEmail = async ({
	order,
	admin,
	polar,
}: {
	order: models.Order;
	admin: { email: string; firstName: string };
	polar: Polar;
}) => {
	try {
		const document = order.is_invoice_generated
			? await polar.orders.invoice(order.id).catch(() => null)
			: order.receipt_number
				? await polar.orders.receipt(order.id).catch(() => null)
				: null;
		if (!document?.url) return;
		const number = order.invoice_number || order.receipt_number || order.id;
		const amountFormatted = formatAmount(order.total_amount, order.currency);
		const htmlContent = await render(
			InvoiceNotificationEmail({
				userName: admin.firstName || "User",
				invoiceNumber: number,
				amountPaid: amountFormatted,
				currency: order.currency,
				date: format(new Date(order.created_at), "MMM dd, yyyy"),
				hostedInvoiceUrl: document.url,
			}),
		);
		const pdf = await downloadPdf(document.url);
		await sendEmail({
			email: admin.email,
			subject: `vlyv invoice ${number} - ${amountFormatted}`,
			text: htmlContent,
			attachments: pdf
				? [{ filename: `vlyv-invoice-${number}.pdf`, content: pdf }]
				: [],
		});
	} catch (error) {
		console.error(
			`Failed to send Polar order email to ${admin.email}`,
			error instanceof Error ? error.message : error,
		);
	}
};

export const sendPolarPaymentFailedEmail = async ({
	subscription,
	admin,
	portalUrl,
}: {
	subscription: models.Subscription;
	admin: { email: string; firstName: string };
	portalUrl: string;
}) => {
	try {
		const htmlContent = await render(
			PaymentFailedEmail({
				userName: admin.firstName || "User",
				invoiceNumber: "Subscription payment",
				amountDue: "See Polar for the outstanding balance",
				currency: subscription.currency,
				date: format(new Date(), "MMM dd, yyyy"),
				hostedInvoiceUrl: portalUrl,
			}),
		);
		await sendEmail({
			email: admin.email,
			subject: "Action required: vlyv payment failed",
			text: htmlContent,
		});
	} catch (error) {
		console.error(
			`Failed to send Polar payment failure email to ${admin.email}`,
			error instanceof Error ? error.message : error,
		);
	}
};
